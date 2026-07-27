import { Router } from 'express';
import Fuse from 'fuse.js';
import * as viem from 'viem';
import { BadRequestError, ServerError } from '../errors';
import {
  isContractName,
  isFunctionSelector,
  isPartialPackageRef,
  parseChainIds,
  parseQueryTypes,
  parseTextQuery,
} from '../helpers';
import { findContractsByAddress, searchContracts } from '../queries/contracts';
import { findSelector, searchFunctions } from '../queries/selectors';
import { findPackagesByPartialRef, searchPackages } from '../queries/packages';
import { ApiDocument } from '../types';

const MAX_TYPED_RESULTS = 100;
const SELECTOR_TYPES = new Set(['error', 'function']);
export type SearchDependencies = {
  findContractsByAddress: typeof findContractsByAddress;
  findPackagesByPartialRef: typeof findPackagesByPartialRef;
  findSelector: typeof findSelector;
  searchContracts: typeof searchContracts;
  searchFunctions: typeof searchFunctions;
  searchPackages: typeof searchPackages;
};
const DEFAULT_SEARCH_DEPENDENCIES: SearchDependencies = {
  findContractsByAddress,
  findPackagesByPartialRef,
  findSelector,
  searchContracts,
  searchFunctions,
  searchPackages,
};

export interface SearchResponse {
  status: number;
  query: string;
  isAddress: boolean;
  isTx: boolean;
  isHex: boolean;
  isPackageRef: boolean;
  isContractName: boolean;
  isFunctionSelector: boolean;
  total: number;
  data: ApiDocument[];
}

function _pushResults(response: SearchResponse, result: { total: number; data: ApiDocument[] }) {
  response.total += result.total;
  response.data.push(...result.data);
}

export function createSearchRouter(overrides: Partial<SearchDependencies> = {}): Router {
  const dependencies = { ...DEFAULT_SEARCH_DEPENDENCIES, ...overrides };
  const search = Router();

  search.get('/search', async (req, res) => {
    const chainIds = parseChainIds(req.query.chainIds);

    if (req.query.query && typeof req.query.query !== 'string') {
      throw new BadRequestError('Invalid "query" param');
    }

    const query = parseTextQuery(req.query.query);
    const rawQuery = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    const types = parseQueryTypes(req.query.types);
    const includesType = (type: ApiDocument['type']) => !types.length || types.includes(type);
    const selectorTypes = types.filter((type): type is 'error' | 'function' => SELECTOR_TYPES.has(type));

    const response = {
      status: 200,
      query,
      isAddress: viem.isAddress(rawQuery),
      isTx: viem.isHash(rawQuery),
      isHex: !viem.isHash(rawQuery) && viem.isHex(rawQuery),
      isPackageRef: isPartialPackageRef(rawQuery),
      isContractName: isContractName(rawQuery),
      isFunctionSelector: isFunctionSelector(rawQuery),
      total: 0,
      data: [] as ApiDocument[],
    } satisfies SearchResponse;

    if (response.isAddress) {
      if (includesType('contract')) {
        const result = await dependencies.findContractsByAddress({
          address: rawQuery as viem.Address,
          limit: 20,
          chainIds,
        });

        _pushResults(response, result);
      }
    } else if (response.isTx) {
      // TODO: tx (look for package names) reg:transactionToPackage
    } else if (response.isPackageRef) {
      if (includesType('package')) {
        const result = await dependencies.findPackagesByPartialRef({
          packageRef: rawQuery,
          chainIds,
        });

        _pushResults(response, result);
      }
    } else if (response.isHex) {
      if (rawQuery.length >= 10 && (!types.length || selectorTypes.length > 0)) {
        const selector = rawQuery.slice(0, 10);
        const result = await dependencies.findSelector({
          selector: selector as viem.Hex,
          limit: 20,
          chainIds,
          types: types.length ? selectorTypes : undefined,
        });

        _pushResults(response, result);
      }
    } else if (response.isFunctionSelector && (!types.length || selectorTypes.length > 0)) {
      const result = await dependencies.findSelector({
        selector: rawQuery as viem.Hex,
        limit: 20,
        chainIds,
        types: types.length ? selectorTypes : undefined,
      });

      _pushResults(response, result);
    } else {
      // Search by contractName
      if (includesType('contract') && response.isContractName && rawQuery.length >= 5) {
        const contractsResults = await dependencies.searchContracts({
          query: rawQuery,
          limit: 20,
          chainIds,
        });

        _pushResults(response, contractsResults);
      }

      // Search by functionName
      if ((!types.length || selectorTypes.length > 0) && query.length >= 5) {
        const contractsResults = await dependencies.searchFunctions({
          query,
          limit: 20,
          chainIds,
          types: types.length ? selectorTypes : undefined,
        });

        _pushResults(response, contractsResults);
      }

      const includeNamespaces = includesType('namespace');
      const includePackages = includesType('package');
      if (includeNamespaces || includePackages) {
        const packagesResult = await dependencies.searchPackages({
          query,
          chainIds,
          limit: types.length ? MAX_TYPED_RESULTS : 20,
          includeNamespaces,
          includePackages,
        });

        _pushResults(response, packagesResult);
      }
    }

    if (types.length && response.data.some(({ type }) => !types.includes(type))) {
      throw new ServerError('Search result violated the requested type scope');
    }

    if (query) {
      const fuzzyOrder = new Fuse<ApiDocument>(response.data, {
        keys: [
          'type',
          {
            name: 'name',
            weight: 2,
          },
          {
            name: 'contractName',
            weight: 2,
          },
          {
            name: 'selector',
            weight: 3,
          },
          {
            name: 'address',
            weight: 3,
          },
        ],
      });

      response.data = fuzzyOrder.search(query).map(({ item }) => item);
    }

    res.json(response);
  });

  return search;
}

export const search = createSearchRouter();
