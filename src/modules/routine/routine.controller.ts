import { Request, Response } from 'express';
import { RoutineService } from './routine.service';

export class RoutineController {
  static async getUserRoutines(req: Request, res: Response) {
    try {
      const userId = req.user!.sub;
      const routines = await RoutineService.getUserRoutines(userId);
      res.status(200).json({ data: routines });
    } catch (error: any) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  static async createRoutine(req: Request, res: Response) {
    try {
      const userId = req.user!.sub;
      const data = { ...req.body, userId };
      const routine = await RoutineService.createRoutine(data);
      res.status(201).json({ data: routine });
    } catch (error: any) {
      res.status(400).json({ error: { message: error.message } });
    }
  }

  static async updateRoutine(req: Request, res: Response) {
    try {
      const userId = req.user!.sub;
      const { id } = req.params;
      const routine = await RoutineService.updateRoutine(id, userId, req.body);
      res.status(200).json({ data: routine });
    } catch (error: any) {
      res.status(400).json({ error: { message: error.message } });
    }
  }

  static async deleteRoutine(req: Request, res: Response) {
    try {
      const userId = req.user!.sub;
      const { id } = req.params;
      await RoutineService.deleteRoutine(id, userId);
      res.status(200).json({ message: 'Routine expense deleted successfully' });
    } catch (error: any) {
      res.status(400).json({ error: { message: error.message } });
    }
  }
}
