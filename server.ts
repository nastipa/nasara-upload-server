import express from "express";
import uploadRoutes from "./routes/upload";

const app = express();

app.use(express.json());

app.use(uploadRoutes);

app.get("/", (_, res) => {
  res.send("Server running 🚀");
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});