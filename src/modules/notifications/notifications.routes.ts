import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { markNotificationsReadSchema } from '../../schemas/notificacoes.js';
import { list, markRead } from './notifications.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/', list);
router.patch('/', validateBody(markNotificationsReadSchema), markRead);

export default router;
