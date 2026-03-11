import { Router } from 'express';
import textRoutes from './text.routes.js';
import imageRoutes from './image.routes.js';
import statusRoutes from './status.routes.js';

const router = Router();

router.use('/status',  statusRoutes);
router.use('/image',   imageRoutes);
router.use('/',        textRoutes);   // /generate and /text

export default router;
