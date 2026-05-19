import { Router } from 'express';
import { verifyEndpoint, receiveMessage } from './webhook.controller';
import { receiveTelegramMessage } from './telegram.controller';
import { verifyWebhookSignature } from '../../middlewares/webhookVerify';

const router = Router();

// Endpoint for Meta to verify the webhook URL
router.get('/', verifyEndpoint);

// Endpoint for receiving webhook events from Meta
router.post('/', verifyWebhookSignature, receiveMessage);

// Endpoint for receiving webhook events from Telegram
router.post('/telegram', receiveTelegramMessage);

export default router;
