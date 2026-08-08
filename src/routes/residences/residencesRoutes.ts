import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import {
  createJoinRequestSchema,
  createResidenceSchema,
  inviteUserSchema,
  respondToAccessRequestSchema,
  transferOwnerSchema,
  updateResidenceSchema,
} from '../../schemas/residencias.js';
import {
  create,
  createJoinRequest,
  getResidence,
  invite,
  leave,
  listResidences,
  regenerateCode,
  removeInvite,
  removeJoinRequest,
  removeMemberHandler,
  respondInvite,
  respondJoinRequest,
  transferOwner,
  update,
} from '../../controllers/residences/residencesController.js';

const router = Router();

router.use(requireAuth);

// --- Residências (nível raiz) ---
router.get('/', listResidences);
router.post('/', validateBody(createResidenceSchema), create);
router.post('/join-requests', validateBody(createJoinRequestSchema), createJoinRequest);
router.delete('/join-requests/:id', removeJoinRequest);
router.patch('/join-requests/:id', validateBody(respondToAccessRequestSchema), respondJoinRequest);
router.patch('/invites/:id', validateBody(respondToAccessRequestSchema), respondInvite);
router.delete('/invites/:id', removeInvite);

// --- Residências (contexto :code) ---
router.get('/:code', getResidence);
router.patch('/:code', validateBody(updateResidenceSchema), update);
router.post('/:code/code', regenerateCode);
router.delete('/:code/members/me', leave);
router.delete('/:code/members/:userId', removeMemberHandler);
router.put('/:code/owner', validateBody(transferOwnerSchema), transferOwner);
router.post('/:code/invites', validateBody(inviteUserSchema), invite);

export default router;
