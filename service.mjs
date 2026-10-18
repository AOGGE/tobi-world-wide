// @ts-check
import node from "@prisma/composer/node";
import { compute } from "@prisma/composer-prisma-cloud";

export default compute({
  name: "tobi-world-wide",
  deps: {},
  build: node({ module: import.meta.url, entry: "server.js" }),
});
