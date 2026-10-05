// Chức năng: kiểm tra nhanh kết nối AI. Chạy: node --env-file=.env scripts/ai-check.js
import { generateJson } from '../ai/provider.js';

try {
    const { data, usage } = await generateJson({
        system: 'Bạn chỉ trả về JSON hợp lệ.',
        prompt: 'Trả về JSON dạng {"ok": true, "greeting": "<lời chào ngắn bằng tiếng Việt>"}',
        maxOutputTokens: 200
    });
    console.log('Kết quả:', data);
    console.log('Token:', usage);
} catch (err) {
    console.error('Lỗi:', err.code, '-', err.message);
    process.exit(1);
}
