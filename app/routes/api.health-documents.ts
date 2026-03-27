import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { getAuthenticatedUser, isValidUuid } from '../lib/route-helpers.server';
import {
  getHealthDocuments,
  addHealthDocument,
  deleteHealthDocument,
  toApiDocument,
} from '../lib/supabase.server';
import { bulkHealthDocumentSchema } from '../../packages/health-core/src/validation';

// ---------------------------------------------------------------------------
// GET: List all health documents for the authenticated user
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth) {
      return json({ error: 'Not logged in' }, { status: 401 });
    }

    const docs = await getHealthDocuments(auth.client);
    return json({ documents: docs.map(toApiDocument) });
  } catch (error) {
    console.error('Error loading health documents:', error);
    Sentry.captureException(error, { tags: { feature: 'health_documents' } });
    return json({ error: 'Failed to load documents' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST: Save documents / DELETE: Remove a document
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
      const documentId = body?.documentId;
      if (!documentId || typeof documentId !== 'string' || !isValidUuid(documentId)) {
        return json({ error: 'Invalid documentId' }, { status: 400 });
      }

      const deleted = await deleteHealthDocument(auth.client, auth.userId, documentId);
      if (!deleted) {
        return json({ error: 'Document not found' }, { status: 404 });
      }
      return json({ success: true });
    }

    // POST: Bulk save documents
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, { status: 405 });
    }

    const body = await request.json();
    const validation = bulkHealthDocumentSchema.safeParse(body);
    if (!validation.success) {
      return json(
        { error: 'Invalid request', details: validation.error.issues },
        { status: 400 },
      );
    }

    const results = await Promise.all(
      validation.data.bulkDocuments.map(doc => addHealthDocument(auth.client, auth.userId, doc)),
    );
    const saved = results.filter(Boolean).map(r => toApiDocument(r!));

    return json({ success: true, documents: saved });
  } catch (error) {
    console.error('Health documents error:', error);
    Sentry.captureException(error, { tags: { feature: 'health_documents' } });
    return json({ error: 'Failed to process request' }, { status: 500 });
  }
}
