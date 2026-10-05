// Chức năng: chạy worker như một tiến trình riêng (Render Background Worker): `node worker/main.js`. Khi dùng cách này, đặt RUN_WORKER=false cho API.
import { initMonitoring } from '../monitoring.js';
import { startWorker } from './index.js';

await initMonitoring();
startWorker();
