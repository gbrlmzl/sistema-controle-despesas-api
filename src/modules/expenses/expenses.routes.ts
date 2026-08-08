import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { expenseSchema, monthClosureSchema } from '../../schemas/despesas.js';
import {
  closeMonthHandler,
  create,
  list,
  listRecurring,
  remove,
  reopenMonthHandler,
  stopRecurrence,
  update,
} from './expenses.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/:code/expenses', list);
router.post('/:code/expenses', validateBody(expenseSchema), create);
router.patch('/:code/expenses/:expenseId', validateBody(expenseSchema), update);
router.delete('/:code/expenses/:expenseId', remove);
router.delete('/:code/expenses/:expenseId/recurrence', stopRecurrence);

router.get('/:code/expenses/recurring', listRecurring);

router.post('/:code/expenses/month-closures', validateBody(monthClosureSchema), closeMonthHandler);
router.delete('/:code/expenses/month-closures/:period', reopenMonthHandler);

export default router;
