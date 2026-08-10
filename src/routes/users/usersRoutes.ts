import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { changePasswordSchema, updateProfileSchema } from '../../schemas/usuarios.js';
import { changePassword, getMe, updateProfile } from '../../controllers/users/usersController.js';

const router = Router();

router.use(requireAuth);

router.get('/me', getMe);
router.patch('/me', validateBody(updateProfileSchema), updateProfile);
router.patch('/me/password', validateBody(changePasswordSchema), changePassword);

export default router;
