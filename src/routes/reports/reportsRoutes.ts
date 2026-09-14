import { Router } from 'express';
import { getReport } from '../../controllers/reports/reportsController.js';
import { requireAuth } from '../../middlewares/auth.js';

const router = Router();

router.use(requireAuth);

router.get('/:code/reports', getReport);

export default router;
