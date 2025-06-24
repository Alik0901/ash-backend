import express from 'express';
import fs from 'fs';
import path from 'path';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// все запросы к /api/fragments/image/:name защищены
router.get('/image/:name', authenticate, async (req, res) => {
  const { name } = req.params;

  // Разрешённый список файлов
  const allowed = new Set([
    'fragment_1_the_whisper.webp',
    /* …все ваши имена… */
    'fragment_8_the_gate.webp',
    'poster.webp'
  ]);
  if (!allowed.has(name)) {
    return res.status(404).end();
  }

  const filePath = path.join(process.cwd(), 'protected', 'fragments', name);
  // Проверяем, что файл реально существует
  if (!fs.existsSync(filePath)) {
    return res.status(404).end();
  }

  res.sendFile(filePath);
});

export default router;
