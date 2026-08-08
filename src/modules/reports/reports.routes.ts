import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { getReport } from './reports.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/:code/reports', getReport);

export default router;
