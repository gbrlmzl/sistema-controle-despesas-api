import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { changePasswordSchema, updateAvatarSchema } from '../../schemas/usuarios.js';
import { changePassword, updateAvatar } from '../../controllers/users/usersController.js';

const router = Router();

router.use(requireAuth);

router.patch('/me', validateBody(updateAvatarSchema), updateAvatar);
router.patch('/me/password', validateBody(changePasswordSchema), changePassword);

export default router;
