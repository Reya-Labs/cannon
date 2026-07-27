import { Request, Response, Router } from 'express';
import { parseChainIds, parseSelectors, parseSelectorType } from '../helpers';
import { findSelector } from '../queries/selectors';
import { ApiSelectorResult } from '../types';

const selector: Router = Router();

selector.get('/selector', async (req: Request, res: Response) => {
  const selectors = parseSelectors(req.query.q);
  const type = parseSelectorType(req.query.type);
  const chainIds = parseChainIds(req.query.chainIds);

  const results: Record<string, ApiSelectorResult[]> = {};

  for (const selector of selectors) {
    results[selector] = (
      await findSelector({
        selector,
        type,
        limit: 10,
        chainIds,
      })
    ).data;
  }

  res.json({
    status: 200,
    results,
  });
});

export { selector };
