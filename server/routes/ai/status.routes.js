import { Router } from 'express';
import { getProviderStatus } from '../../services/ai/factories/providerFactory.js';

const router = Router();

router.get('/', (req, res) => {
  res.json(getProviderStatus());
});

export default router;
