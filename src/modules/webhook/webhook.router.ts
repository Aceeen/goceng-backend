import { Router } from 'express';
import { verifyEndpoint, receiveMessage } from './webhook.controller';
import { verifyWebhookSignature } from '../../middlewares/webhookVerify';

const router = Router();

// Endpoint for Meta to verify the webhook URL
router.get('/', verifyEndpoint);

// Endpoint for receiving webhook events from Meta
router.post('/', verifyWebhookSignature, receiveMessage);

export default router;
