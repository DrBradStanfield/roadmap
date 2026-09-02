/**
 * The two discovery documents an MCP client fetches before it has a token
 * (US-32, design §6). They must sit at the HOST root, so they cannot live
 * under `/mcp` — hence a second splat route.
 *
 *   /.well-known/oauth-protected-resource        RFC 9728
 *   /.well-known/oauth-protected-resource/mcp    RFC 9728, path-suffixed form
 *   /.well-known/oauth-authorization-server      RFC 8414
 *
 * Three details are load-bearing and each was learned the hard way by someone:
 * `resource` must equal the URL the user typed, EXACTLY; `authorization_servers`
 * must list our issuer FIRST, because Claude uses the first entry and does not
 * fall back; and the metadata must advertise BOTH
 * `client_id_metadata_document_supported` and `"none"` in
 * `token_endpoint_auth_methods_supported`, or Claude silently drops to DCR.
 *
 * These are the only two unauthenticated documents this server publishes.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { isMcpEnabled, issuer, resourceUrl } from '../lib/mcp-config.server';

/** Public, cacheable, and identical for everyone — no `Vary`, no CORS. */
const HEADERS = { 'Cache-Control': 'public, max-age=3600' };

export async function loader({ params }: LoaderFunctionArgs) {
  if (!isMcpEnabled()) return new Response('Not found', { status: 404 });
  const path = (params['*'] ?? '').replace(/^\/+|\/+$/g, '');

  if (path === 'oauth-protected-resource' || path === 'oauth-protected-resource/mcp') {
    return Response.json(
      {
        resource: resourceUrl(),
        authorization_servers: [issuer()],
        bearer_methods_supported: ['header'],
        scopes_supported: ['health.read', 'health.append'],
        resource_name: 'Health Roadmap',
        resource_documentation: 'https://drstanfield.com/pages/health-roadmap',
      },
      { headers: HEADERS },
    );
  }

  if (path === 'oauth-authorization-server' || path === 'oauth-authorization-server/mcp') {
    return Response.json(
      {
        issuer: issuer(),
        authorization_endpoint: `${issuer()}/mcp/authorize`,
        token_endpoint: `${issuer()}/mcp/token`,
        registration_endpoint: `${issuer()}/mcp/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        // Both, deliberately: CIMD is what avoids a registry, and `none` is what
        // keeps DCR working for clients that do not speak CIMD.
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        // RFC 9207, from day one — an authorization response says who issued it.
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['health.read', 'health.append'],
      },
      { headers: HEADERS },
    );
  }

  return new Response('Not found', { status: 404 });
}
