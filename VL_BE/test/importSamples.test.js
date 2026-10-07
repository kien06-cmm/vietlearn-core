// Chức năng: kiểm thử file mẫu nhập đề - dựng file .xlsx/.docx mẫu rồi đọc lại bằng bộ đọc thật. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_FORMATS, SAMPLE_QUESTIONS, buildSample } from '../ai/importSamples.js';
import { readImportFile } from '../ai/importFile.js';
import { finalizeImport } from '../ai/importRules.js';

for (const format of SAMPLE_FORMATS) {
    test(`file mẫu .${format} đọc lại đủ ${SAMPLE_QUESTIONS.length} câu, đúng đề và đáp án`, async () => {
        const { buffer, fileName } = await buildSample(format);
        const items = await readImportFile({ fileName, buffer });
        const { questions, errors } = finalizeImport(items);

        assert.deepEqual(errors, []);
        assert.equal(questions.length, SAMPLE_QUESTIONS.length);
        questions.forEach(({ q }, i) => {
            assert.equal(q.stem, SAMPLE_QUESTIONS[i].stem);
            assert.equal(q.correct, 'ABCD'.indexOf(SAMPLE_QUESTIONS[i].answer));
        });
    });
}

test('định dạng lạ bị từ chối', async () => {
    await assert.rejects(() => buildSample('pdf'));
});
