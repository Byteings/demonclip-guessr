/** Local server for Clip//Guess. Run: node serve.mjs */
import { createAppServer } from "./server/index.mjs";

const PORT = Number(process.env.PORT) || 5173;
const server = await createAppServer();

server.listen(PORT, () => {
  console.log(`Clip//Guess running at http://localhost:${PORT}`);
});
