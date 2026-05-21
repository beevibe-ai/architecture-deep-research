import { fileURLToPath } from "node:url";
import path from "node:path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: [
    tailwindcss({ config: path.join(here, "tailwind.config.js") }),
    autoprefixer()
  ]
};
