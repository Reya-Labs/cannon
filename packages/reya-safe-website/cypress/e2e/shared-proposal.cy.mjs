import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEYS = [1, 2, 3, 4, 5].map(
  (value) => `0x${value.toString(16).padStart(64, '0')}`
);
const OWNERS = PRIVATE_KEYS.map((key) => privateKeyToAccount(key));

function fixture(name) {
  const value = Cypress.env(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing deterministic E2E fixture ${name}`);
  }
  return value;
}

function injectedWallet(account) {
  const address = account.address.toLowerCase();
  return {
    on() {},
    removeListener() {},
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x6c1';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return [address];
      }
      if (method === 'eth_signTypedData_v4') {
        if (
          !Array.isArray(params) ||
          params.length !== 2 ||
          params[0] !== address ||
          typeof params[1] !== 'string'
        ) {
          throw new Error('unexpected deterministic wallet request');
        }
        const encoded = JSON.parse(params[1]);
        if (
          encoded.domain?.chainId !== 1729 ||
          encoded.primaryType !== 'SafeTx' ||
          encoded.domain?.verifyingContract !== fixture('safeAddress')
        ) {
          throw new Error('deterministic wallet rejected changed typed data');
        }
        return account.signTypedData({
          domain: encoded.domain,
          message: encoded.message,
          primaryType: encoded.primaryType,
          types: { SafeTx: encoded.types.SafeTx },
        });
      }
      throw new Error(`deterministic wallet rejected ${method}`);
    },
  };
}

function visitAs(ownerIndex) {
  const account = OWNERS[ownerIndex];
  cy.visit('/', {
    onBeforeLoad(window) {
      Object.defineProperty(window, 'ethereum', {
        configurable: false,
        enumerable: false,
        value: injectedWallet(account),
        writable: false,
      });
    },
  });
  cy.contains('Safe nonce 477 · threshold 3 of 5');
  return account.address.toLowerCase();
}

function createExactReview() {
  cy.get('input[aria-label="Deployment data"]')
    .clear()
    .type(fixture('cannonfileUrl'), { delay: 0 });
  cy.get('input[aria-label="Previous package"]')
    .clear()
    .type(`ipfs://${fixture('previousCid')}`, { delay: 0 });
  cy.window().then(async (window) => {
    const response = await window.fetch('http://127.0.0.1:8787/preview/1729', {
      body: JSON.stringify({
        chainId: 1729,
        commit: fixture('sourceCommit'),
        partialDeployCid: null,
        previousPackageCid: fixture('previousCid'),
        safeAddress: fixture('safeAddress'),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const declared = response.headers.get('x-reya-content-length');
    const body = await response.text();
    expect(response.status).to.equal(200);
    expect(response.headers.get('content-type')).to.equal('application/json');
    expect(declared).to.equal(
      String(new TextEncoder().encode(body).byteLength)
    );
  });
  cy.contains('button', 'Preview Transactions to Queue').click();
  cy.contains('1 ordered Safe call(s) · 0 deployer prerequisite(s)');
  cy.contains('Decoded calldata');
  cy.contains('upgradeTo(address)');
  cy.contains('button', 'Execution pending security review').should(
    'be.disabled'
  );
}

function connectReviewAndSign(expectedAction) {
  cy.contains('button', 'Connect wallet').click();
  cy.contains('button', 'Owner wallet connected');
  createExactReview();
  cy.get('input[type="checkbox"]').check();
  cy.contains('button', expectedAction).click();
}

function sharedProposal() {
  return cy.get('section[aria-label="Shared Safe proposal"]');
}

describe('shared Safe proposal coordination', () => {
  it('persists one 3-of-5 proposal across independent signer visits', () => {
    const ownerA = visitAs(0);
    sharedProposal().contains('No active proposal exists for Safe nonce 477');
    connectReviewAndSign('Sign and stage proposal');
    cy.contains('Shared proposal created · 1 signature(s)');
    sharedProposal().contains('1 of 3 required');
    sharedProposal().contains('Awaiting signatures');
    sharedProposal().contains(ownerA).parent().contains('signed');

    let safeTxHash;
    sharedProposal()
      .find('code')
      .first()
      .invoke('text')
      .then((value) => {
        expect(value).to.match(/^0x[0-9a-f]{64}$/);
        safeTxHash = value;
      });
    cy.screenshot('01-owner-a-created-1-of-3', { capture: 'fullPage' });

    const ownerB = visitAs(1);
    sharedProposal().contains('1 of 3 required');
    sharedProposal().contains(ownerA).parent().contains('signed');
    sharedProposal().contains(ownerB).parent().contains('awaiting');
    sharedProposal()
      .find('code')
      .first()
      .invoke('text')
      .then((value) => expect(value).to.equal(safeTxHash));
    cy.screenshot('02-owner-b-discovers-shared-proposal', {
      capture: 'fullPage',
    });
    connectReviewAndSign('Sign shared proposal');
    cy.contains('Signature added · 2 signature(s)');
    sharedProposal().contains('2 of 3 required');
    sharedProposal().contains(ownerB).parent().contains('signed');
    cy.screenshot('03-owner-b-added-2-of-3', { capture: 'fullPage' });

    const ownerC = visitAs(2);
    sharedProposal().contains('2 of 3 required');
    sharedProposal().contains(ownerC).parent().contains('awaiting');
    sharedProposal()
      .find('code')
      .first()
      .invoke('text')
      .then((value) => expect(value).to.equal(safeTxHash));
    connectReviewAndSign('Sign shared proposal');
    cy.contains('Signature added · 3 signature(s)');
    sharedProposal().contains('3 of 3 required');
    sharedProposal().contains('Reached');
    sharedProposal().contains(ownerC).parent().contains('signed');
    cy.contains('button', 'Execution pending security review').should(
      'be.disabled'
    );
    cy.screenshot('04-owner-c-reaches-threshold-3-of-3', {
      capture: 'fullPage',
    });
  });
});
