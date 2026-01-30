import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import jwt from 'jsonwebtoken';
import {
  findOrCreateProfile,
  getHealthProfile,
  saveHealthProfile,
  type HealthProfile,
} from '../lib/supabase.server';
import { healthInputSchema } from '../../packages/health-core/src/validation';

// Convert database format to camelCase for the client
function dbToInputs(profile: HealthProfile) {
  const inputs: Record<string, unknown> = {};

  if (profile.height_cm !== null) inputs.heightCm = profile.height_cm;
  if (profile.weight_kg !== null) inputs.weightKg = profile.weight_kg;
  if (profile.waist_cm !== null) inputs.waistCm = profile.waist_cm;
  if (profile.sex !== null) inputs.sex = profile.sex;
  if (profile.birth_year !== null) inputs.birthYear = profile.birth_year;
  if (profile.birth_month !== null) inputs.birthMonth = profile.birth_month;
  if (profile.hba1c !== null) inputs.hba1c = profile.hba1c;
  if (profile.ldl_c !== null) inputs.ldlC = profile.ldl_c;
  if (profile.hdl_c !== null) inputs.hdlC = profile.hdl_c;
  if (profile.triglycerides !== null) inputs.triglycerides = profile.triglycerides;
  if (profile.fasting_glucose !== null) inputs.fastingGlucose = profile.fasting_glucose;
  if (profile.systolic_bp !== null) inputs.systolicBp = profile.systolic_bp;
  if (profile.diastolic_bp !== null) inputs.diastolicBp = profile.diastolic_bp;

  return inputs;
}

// Convert camelCase inputs to snake_case database format
function inputsToDb(inputs: Record<string, unknown>) {
  return {
    height_cm: inputs.heightCm ?? null,
    weight_kg: inputs.weightKg ?? null,
    waist_cm: inputs.waistCm ?? null,
    sex: inputs.sex ?? null,
    birth_year: inputs.birthYear ?? null,
    birth_month: inputs.birthMonth ?? null,
    hba1c: inputs.hba1c ?? null,
    ldl_c: inputs.ldlC ?? null,
    hdl_c: inputs.hdlC ?? null,
    triglycerides: inputs.triglycerides ?? null,
    fasting_glucose: inputs.fastingGlucose ?? null,
    systolic_bp: inputs.systolicBp ?? null,
    diastolic_bp: inputs.diastolicBp ?? null,
  };
}

// CORS headers for customer account extension requests
// Customer account extensions run on shopify.com, so we restrict the origin
function corsHeaders(request?: Request) {
  const origin = request?.headers.get('Origin') || '';
  // Allow requests from Shopify's customer account domain
  const allowedOrigin =
    origin.endsWith('.shopify.com') ||
    origin.endsWith('.myshopify.com') ||
    origin.endsWith('.shopifycdn.com')
      ? origin
      : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}

// Verify Shopify session token JWT and extract customer ID
function verifySessionToken(authHeader: string | null): string {
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

  // The `sub` claim contains the customer's GID: gid://shopify/Customer/123
  const sub = decoded.sub;
  if (!sub) {
    throw new Error('Token missing sub claim — customer not logged in');
  }

  // Extract numeric ID from GID and validate format
  const match = sub.match(/^gid:\/\/shopify\/Customer\/(\d+)$/);
  if (!match) {
    throw new Error('Invalid customer GID format in sub claim');
  }

  return match[1];
}

// Handle CORS preflight and POST (save health profile)
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders(request) });
  }

  try {
    const customerId = verifySessionToken(request.headers.get('Authorization'));

    const body = await request.json();
    const { inputs } = body as { inputs: unknown };
    if (!inputs) {
      return json(
        { success: false, error: 'Missing inputs' },
        { status: 400, headers: corsHeaders(request) },
      );
    }

    // Validate inputs against Zod schema (partial — all fields optional for saves)
    const validation = healthInputSchema.partial().safeParse(inputs);
    if (!validation.success) {
      return json(
        { success: false, error: 'Invalid input', details: validation.error.issues },
        { status: 400, headers: corsHeaders(request) },
      );
    }
    const validatedInputs = validation.data;

    const profile = await findOrCreateProfile(customerId);
    if (!profile) {
      return json(
        { success: false, error: 'Could not find or create profile' },
        { status: 500, headers: corsHeaders(request) },
      );
    }

    const dbData = inputsToDb(validatedInputs);
    const savedProfile = await saveHealthProfile(profile.id, dbData);

    if (!savedProfile) {
      return json(
        { success: false, error: 'Failed to save' },
        { status: 500, headers: corsHeaders(request) },
      );
    }

    return json(
      { success: true, data: dbToInputs(savedProfile) },
      { headers: corsHeaders(request) },
    );
  } catch (error) {
    console.error('Customer health profile save error:', error);
    return json(
      { success: false, error: 'Authentication failed' },
      { status: 401, headers: corsHeaders(request) },
    );
  }
}

// GET - Load health profile (authenticated via Shopify session token JWT)
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  try {
    const customerId = verifySessionToken(request.headers.get('Authorization'));

    const profile = await findOrCreateProfile(customerId);
    if (!profile) {
      return json(
        { success: false, error: 'Could not find or create profile' },
        { status: 500, headers: corsHeaders(request) },
      );
    }

    const healthProfile = await getHealthProfile(profile.id);
    if (!healthProfile) {
      return json({ success: true, data: null }, { headers: corsHeaders(request) });
    }

    return json(
      { success: true, data: dbToInputs(healthProfile) },
      { headers: corsHeaders(request) },
    );
  } catch (error) {
    // Log full error server-side, return generic message to client
    console.error('Customer health profile auth error:', error);
    return json(
      { success: false, error: 'Authentication failed' },
      { status: 401, headers: corsHeaders(request) },
    );
  }
}
