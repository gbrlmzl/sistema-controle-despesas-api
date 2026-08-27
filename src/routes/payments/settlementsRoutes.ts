import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { receiptIntentSchema, waiveSettlementSchema } from '../../schemas/acertos.js';
import {
  listSettlements,
  createIntent,
  completeUpload,
  confirmReceivedHandler,
  waive,
  downloadUrl,
} from '../../controllers/payments/settlementsController.js';

const router = Router();

router.use(requireAuth);

router.get('/:code/closures/:period/settlements', listSettlements);
router.post('/:code/closures/:period/settlements/:settlementId/receipts', validateBody(receiptIntentSchema), createIntent);
router.post('/:code/closures/:period/settlements/:settlementId/receipts/:receiptId/complete', completeUpload);
router.post('/:code/closures/:period/settlements/:settlementId/confirm', confirmReceivedHandler);
router.post('/:code/closures/:period/settlements/:settlementId/waive', validateBody(waiveSettlementSchema), waive);
router.get('/:code/closures/:period/receipts/:receiptId/url', downloadUrl);

export default router;
