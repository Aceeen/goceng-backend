import { Router } from 'express';
import { RoutineController } from './routine.controller';
import { authenticate } from '../../middlewares/authenticate';

const router = Router();

router.use(authenticate);

router.get('/', RoutineController.getUserRoutines);
router.post('/', RoutineController.createRoutine);
router.put('/:id', RoutineController.updateRoutine);
router.delete('/:id', RoutineController.deleteRoutine);

export const routineRouter = router;
