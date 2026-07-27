import { REYA_CHAIN_ID, REYA_READ_LIMITS } from './config.mjs';
import { fail } from './errors.mjs';
import {
  validateChainsResponse,
  validatePackageNameInput,
  validatePackageRefInput,
  validatePackageResponse,
  validatePackagesResponse,
  validateSearchInput,
  validateSearchResponse,
  validateSelectorInput,
  validateSelectorResponse,
} from './schema.mjs';
import { boundedRequest, parseJson } from './transport.mjs';

export const QUERY_ROUTE_PATHS = Object.freeze({
  chains: '/query/chains',
  packages: '/query/packages',
  search: '/query/search',
  selector: '/query/selector',
});

function routeUrl(serviceOrigin, pathname) {
  const url = new URL(serviceOrigin);
  url.pathname = pathname;
  return url;
}

async function getJson(config, url) {
  const bytes = await boundedRequest({
    accept: 'application/json',
    deadlineMs: config.queryDeadlineMs,
    fetchImpl: config.fetchImpl,
    maximumBytes: REYA_READ_LIMITS.queryBytes,
    method: 'GET',
    responseMediaType: 'application/json',
    url: url.href,
  });
  return parseJson(bytes);
}

export function createQueryClient(config) {
  return Object.freeze({
    async chains(...args) {
      if (args.length !== 0) fail('INVALID_INPUT');
      const url = routeUrl(config.serviceOrigin, QUERY_ROUTE_PATHS.chains);
      return validateChainsResponse(await getJson(config, url));
    },

    async packageByRef(...args) {
      if (args.length !== 1) fail('INVALID_INPUT');
      const [input] = args;
      const packageRef = validatePackageRefInput(input);
      const url = routeUrl(
        config.serviceOrigin,
        `${QUERY_ROUTE_PATHS.packages}/${encodeURIComponent(
          packageRef.fullPackageRef
        )}/${REYA_CHAIN_ID}`
      );
      return validatePackageResponse(await getJson(config, url), packageRef);
    },

    async packagesByName(...args) {
      if (args.length !== 1) fail('INVALID_INPUT');
      const [input] = args;
      const packageName = validatePackageNameInput(input);
      const url = routeUrl(
        config.serviceOrigin,
        `${QUERY_ROUTE_PATHS.packages}/${encodeURIComponent(packageName)}`
      );
      url.searchParams.set('chainIds', String(REYA_CHAIN_ID));
      return validatePackagesResponse(await getJson(config, url), packageName);
    },

    async search(...args) {
      if (args.length !== 1) fail('INVALID_INPUT');
      const [input] = args;
      const { normalizedQuery, query, types } = validateSearchInput(input);
      const url = routeUrl(config.serviceOrigin, QUERY_ROUTE_PATHS.search);
      url.searchParams.set('chainIds', String(REYA_CHAIN_ID));
      url.searchParams.set('query', query);
      if (types.length > 0) url.searchParams.set('types', types.join(','));
      return validateSearchResponse(
        await getJson(config, url),
        normalizedQuery,
        types,
        query
      );
    },

    async selector(...args) {
      if (args.length !== 1) fail('INVALID_INPUT');
      const [input] = args;
      const { selectors, type } = validateSelectorInput(input);
      const url = routeUrl(config.serviceOrigin, QUERY_ROUTE_PATHS.selector);
      url.searchParams.set('chainIds', String(REYA_CHAIN_ID));
      url.searchParams.set('q', selectors.join(','));
      if (type !== undefined) url.searchParams.set('type', type);
      return validateSelectorResponse(
        await getJson(config, url),
        selectors,
        type
      );
    },
  });
}
