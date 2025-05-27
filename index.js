import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import playerRoutes from './routes/player.js';
import validateRoute from './routes/validate.js'; // ✅ уже импортировал через import

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/validate', validateRoute); // ✅ используй переменную, уже импортированную через import
app.use('/api', playerRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
