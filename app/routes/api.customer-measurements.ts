import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import jwt from 'jsonwebtoken';
import { unauthenticated } from '../shopify.server';
import {
  getOrCreateSupabaseUser,
  createUserClient,
  getMeasurements,
  getLatestMeasurements,
  addMeasurement,
  deleteMeasurement,
  toApiMeasurement,
} from '../lib/supabase.server';
import { measurementSchema, METRIC_TYPES } from '../../packages/health-core/src/validation';
import { rateLimit } from '../lib/rate-limit.server';

function corsHeaders(request?: Request) {
  const origin = request?.headers.get('Origin') || '';
  const allowedOrigin =
    origin.endsWith('.shopify.com') ||
    origin.endsWith('.myshopify.com') ||
    origin.endsWith('.shopifycdn.com')
      ? origin
      : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}

interface SessionTokenPayload {
  sub: string;
  dest: string;
}

function verifySessionToken(authHeader: string | null): SessionTokenPayload {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error('SHOPIFY_API_SECRET not configured');
  }

  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    audience: process.env.SHOPIFY_API_KEY,
  }) as jwt.JwtPayload;

  const sub = decoded.sub;
  if (!sub) {
    throw new Error('Token missing sub claim — customer not logged in');
  }

  const match = sub.match(/^gid:\/\/shopify\/Customer\/(\d+)$/);
  if (!match) {
    throw new Error('Invalid customer GID format in sub claim');
  }

  const dest = decoded.dest;
  if (!dest) {
    throw new Error('Token missing dest claim');
  }

  // dest may be "https://mystore.myshopify.com" or just "mystore.myshopify.com"
  const shopDomain = dest.includes('://') ? new URL(dest).hostname : dest;

  return { sub: match[1], dest: shopDomain };
}

async function getCustomerEmail(shopDomain: string, customerId: string): Promise<string | null> {
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await admin.graphql(`
      query getCustomer($id: ID!) {
        customer(id: $id) {
          email
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const { data } = await response.json();
    return data?.customer?.email || null;
  } catch (error) {
    console.error('Error looking up customer email:', error);
    return null;
  }
}

// GET — Load measurements (authenticated via JWT)
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const { allowed } = rateLimit(request);
  if (!allowed) {
    return json(
      { success: false, error: 'Too many requests' },
      { status: 429, headers: corsHeaders(request) },
    );
  }

  try {
    const { sub: customerId, dest: shopDomain } = verifySessionToken(request.headers.get('Authorization'));
    const email = await getCustomerEmail(shopDomain, customerId);
    if (!email) {
      return json(
        { success: false, error: 'Could not retrieve customer email' },
        { status: 500, headers: corsHeaders(request) },
      );
    }

    const userId = await getOrCreateSupabaseUser(customerId, email);
    const client = createUserClient(userId);

    const url = new URL(request.url);
    const metricType = url.searchParams.get('metric_type');

    if (metricType) {
      if (!METRIC_TYPES.includes(metricType as any)) {
        return json(
          { success: false, error: 'Invalid metric_type' },
          { status: 400, headers: corsHeaders(request) },
        );
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);
      const measurements = await getMeasurements(client, metricType, limit);
      return json({ success: true, data: measurements.map(toApiMeasurement) }, { headers: corsHeaders(request) });
    }

    const latest = await getLatestMeasurements(client);
    return json({ success: true, data: latest.map(toApiMeasurement) }, { headers: corsHeaders(request) });
  } catch (error) {
    console.error('Customer measurements auth error:', error);
    return json(
      { success: false, error: 'Authentication failed' },
      { status: 401, headers: corsHeaders(request) },
    );
  }
}

// POST — Add measurement | DELETE — Remove measurement | OPTIONS — CORS preflight
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const { allowed } = rateLimit(request);
  if (!allowed) {
    return json(
      { success: false, error: 'Too many requests' },
      { status: 429, headers: corsHeaders(request) },
    );
  }

  try {
    const { sub: customerId, dest: shopDomain } = verifySessionToken(request.headers.get('Authorization'));
    const email = await getCustomerEmail(shopDomain, customerId);
    if (!email) {
      return json(
        { success: false, error: 'Could not retrieve customer email' },
        { status: 500, headers: corsHeaders(request) },
      );
    }

    const userId = await getOrCreateSupabaseUser(customerId, email);
    const client = createUserClient(userId);

    const body = await request.json();

    if (request.method === 'POST') {
      const validation = measurementSchema.safeParse(body);
      if (!validation.success) {
        return json(
          { success: false, error: 'Invalid input', details: validation.error.issues },
          { status: 400, headers: corsHeaders(request) },
        );
      }

      const { metricType, value, recordedAt } = validation.data;
      const measurement = await addMeasurement(client, userId, metricType, value, recordedAt);

      if (!measurement) {
        return json(
          { success: false, error: 'Failed to save' },
          { status: 500, headers: corsHeaders(request) },
        );
      }

      return json(
        { success: true, data: toApiMeasurement(measurement) },
        { headers: corsHeaders(request) },
      );
    }

    if (request.method === 'DELETE') {
      const { measurementId } = body as { measurementId?: string };
      if (!measurementId) {
        return json(
          { success: false, error: 'measurementId required' },
          { status: 400, headers: corsHeaders(request) },
        );
      }

      const deleted = await deleteMeasurement(client, measurementId);
      return json({ success: deleted }, { headers: corsHeaders(request) });
    }

    return json(
      { success: false, error: 'Method not allowed' },
      { status: 405, headers: corsHeaders(request) },
    );
  } catch (error) {
    console.error('Customer measurements error:', error);
    return json(
      { success: false, error: 'Authentication failed' },
      { status: 401, headers: corsHeaders(request) },
    );
  }
}
