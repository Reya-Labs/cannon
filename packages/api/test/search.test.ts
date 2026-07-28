/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { createSearchRouter, type SearchDependencies } from '../src/routes/search';

const openServers = new Set<Server>();

async function serve(dependencies: SearchDependencies): Promise<string> {
  const app = express();
  app.use(createSearchRouter(dependencies));
  app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next;
    response.status(500).json({ status: 500 });
  });
  const server = createServer(app);
  openServers.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to TCP');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  openServers.clear();
});

describe('search route request scope', () => {
  it('applies requested types and raw-query classification before every query branch', async () => {
    const calls: { name: keyof SearchDependencies; params: unknown }[] = [];
    const dependencies: SearchDependencies = {
      findContractsByAddress: async (params) => {
        calls.push({ name: 'findContractsByAddress', params });
        return { data: [], total: 0 };
      },
      findPackagesByPartialRef: async (params) => {
        calls.push({ name: 'findPackagesByPartialRef', params });
        return { data: [], total: 0 };
      },
      findSelector: async (params) => {
        calls.push({ name: 'findSelector', params });
        return { data: [], total: 0 };
      },
      searchContracts: async (params) => {
        calls.push({ name: 'searchContracts', params });
        return { data: [], total: 0 };
      },
      searchFunctions: async (params) => {
        calls.push({ name: 'searchFunctions', params });
        return { data: [], total: 0 };
      },
      searchPackages: async (params) => {
        calls.push({ name: 'searchPackages', params });
        return { data: [], total: 0 };
      },
    };
    const baseUrl = await serve(dependencies);
    const request = async (query: string) => {
      calls.length = 0;
      const response = await fetch(`${baseUrl}/search?chainIds=1729&${query}`);
      assert.equal(response.status, 200);
      return response.json() as Promise<Record<string, unknown>>;
    };

    const address = '0x0000000000000000000000000000000000000001';
    await request(`query=${address}&types=function`);
    assert.deepEqual(calls, []);
    const addressResponse = await request(`query=${address}&types=contract`);
    assert.equal(addressResponse.isAddress, true);
    assert.deepEqual(calls, [
      {
        name: 'findContractsByAddress',
        params: { address, chainIds: [1729], limit: 20 },
      },
    ]);

    const packageRef = encodeURIComponent('valid-package:1.2.3@main');
    await request(`query=${packageRef}&types=contract`);
    assert.deepEqual(calls, []);
    const packageResponse = await request(`query=${packageRef}&types=package`);
    assert.equal(packageResponse.isPackageRef, true);
    assert.deepEqual(calls, [
      {
        name: 'findPackagesByPartialRef',
        params: {
          chainIds: [1729],
          packageRef: 'valid-package:1.2.3@main',
        },
      },
    ]);

    for (const invalidPackageRef of [`valid-package:${'v'.repeat(33)}@main`, `valid-package:1.2.3@${'p'.repeat(25)}`]) {
      const invalidResponse = await request(`query=${encodeURIComponent(invalidPackageRef)}&types=package`);
      assert.equal(invalidResponse.isPackageRef, false);
      assert.equal(invalidResponse.status, 200);
      assert.equal(
        calls.some(({ name }) => name === 'findPackagesByPartialRef'),
        false
      );
    }

    await request('query=0x82b42900&types=error');
    assert.deepEqual(calls, [
      {
        name: 'findSelector',
        params: {
          chainIds: [1729],
          limit: 20,
          selector: '0x82b42900',
          types: ['error'],
        },
      },
    ]);

    const signatureResponse = await request('query=owner%28%29&types=function');
    assert.equal(signatureResponse.query, 'owner');
    assert.deepEqual(calls, [
      {
        name: 'searchFunctions',
        params: {
          chainIds: [1729],
          limit: 20,
          query: 'owner',
          types: ['function'],
        },
      },
    ]);

    const contractResponse = await request('query=CoreProxy&types=contract');
    assert.equal(contractResponse.isContractName, true);
    assert.deepEqual(calls, [
      {
        name: 'searchContracts',
        params: {
          chainIds: [1729],
          limit: 20,
          query: 'CoreProxy',
        },
      },
    ]);

    await request('query=valid-package&types=namespace');
    assert.deepEqual(calls, [
      {
        name: 'searchPackages',
        params: {
          chainIds: [1729],
          includeNamespaces: true,
          includePackages: false,
          limit: 100,
          query: 'valid-package',
        },
      },
    ]);

    await request('query=valid-package&types=package');
    assert.deepEqual(calls, [
      {
        name: 'searchPackages',
        params: {
          chainIds: [1729],
          includeNamespaces: false,
          includePackages: true,
          limit: 100,
          query: 'valid-package',
        },
      },
    ]);
  });

  it('fails closed if a query dependency violates requested type scope', async () => {
    const noResults = async () => ({ data: [], total: 0 });
    const dependencies: SearchDependencies = {
      findContractsByAddress: noResults,
      findPackagesByPartialRef: noResults,
      findSelector: noResults,
      searchContracts: noResults,
      searchFunctions: async () => ({
        data: [
          {
            name: 'Unauthorized()',
            selector: '0x82b42900',
            type: 'error' as const,
          },
        ],
        total: 1,
      }),
      searchPackages: noResults,
    };
    const baseUrl = await serve(dependencies);

    const response = await fetch(`${baseUrl}/search?query=owner%28%29&types=function`);

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { status: 500 });
  });
});
