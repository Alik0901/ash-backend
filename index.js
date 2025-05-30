import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import playerRoutes       from './routes/player.js';
import validateRoute      from './routes/validate.js';
import validateFinalRoute from './routes/validateFinal.js';  // <-- новый импорт

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// роут для валидации initData от Telegram
app.use('/api/validate', validateRoute);

// роут для валидации финальной фразы
app.use('/api/validate-final', validateFinalRoute);

// все остальные API (игроки и т.п.)
app.use('/api', playerRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
