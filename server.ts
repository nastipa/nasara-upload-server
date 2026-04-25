import express from "express";
import uploadRoutes from "./routes/upload";

const app = express();

app.use(express.json());

app.use(uploadRoutes);

app.get("/", (_, res) => {
  res.send("Nasara Upload Server 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});