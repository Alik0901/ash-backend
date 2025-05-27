import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import playerRoutes from './routes/player.js';
import validateRoute from './routes/validate.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Роут для валидации Telegram initData
app.use('/api/validate', validateRoute);

// Роуты для работы с игроками
app.use('/api', playerRoutes);

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
