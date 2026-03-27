import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { getAuthenticatedUser, isValidUuid } from '../lib/route-helpers.server';
import {
  getLabValues,
  addLabValues,
  deleteLabValue,
  toApiLabValue,
} from '../lib/supabase.server';
import { bulkLabValueSchema } from '../../packages/health-core/src/validation';

// ---------------------------------------------------------------------------
// GET: List lab values for the authenticated user
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth) {
      return json({ error: 'Not logged in' }, { status: 401 });
    }

    const url = new URL(request.url);
    const metricName = url.searchParams.get('metric_name') || undefined;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const rows = await getLabValues(auth.client, metricName, limit, offset);
    return json({ labValues: rows.map(toApiLabValue) });
  } catch (error) {
    console.error('Error loading lab values:', error);
    Sentry.captureException(error, { tags: { feature: 'lab_values' } });
    return json({ error: 'Failed to load lab values' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST: Bulk save / DELETE: Remove a lab value
// ---------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth) {
      return json({ error: 'Not logged in' }, { status: 401 });
    }

    // DELETE
    if (request.method === 'DELETE') {
      const body = await request.json();
      const labValueId = body?.labValueId;
      if (!labValueId || typeof labValueId !== 'string' || !isValidUuid(labValueId)) {
        return json({ error: 'Invalid labValueId' }, { status: 400 });
      }

      const deleted = await deleteLabValue(auth.client, auth.userId, labValueId);
      if (!deleted) {
        return json({ error: 'Lab value not found' }, { status: 404 });
      }
      return json({ success: true });
    }

    // POST: Bulk save
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, { status: 405 });
    }

    const body = await request.json();
    const validation = bulkLabValueSchema.safeParse(body);
    if (!validation.success) {
      return json(
        { error: 'Invalid request', details: validation.error.issues },
        { status: 400 },
      );
    }

    const saved = await addLabValues(auth.client, auth.userId, validation.data.bulkLabValues);
    return json({ success: true, labValues: saved.map(toApiLabValue) });
  } catch (error) {
    console.error('Lab values error:', error);
    Sentry.captureException(error, { tags: { feature: 'lab_values' } });
    return json({ error: 'Failed to process request' }, { status: 500 });
  }
}
