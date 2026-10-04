import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs';

const server = new Server(
  { name: "VietLearn-System", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Báo cho Claude biết nó có khả năng quét toàn bộ dự án
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "quet_thu_muc_du_an",
    description: "Xem danh sách các file và thư mục trong toàn bộ dự án VietLearn (cả BE và FE)",
    inputSchema: {
      type: "object",
      properties: {
        duong_dan: { type: "string", description: "Đường dẫn thư mục, mặc định cứ để D:/VietLearn" }
      },
      required: ["duong_dan"]
    }
  }]
}));

// Thực thi lệnh quét khi Claude yêu cầu
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "quet_thu_muc_du_an") {
    const targetPath = request.params.arguments.duong_dan;
    try {
      // Đọc các file/thư mục có trong ổ D:/VietLearn
      const files = fs.readdirSync(targetPath);
      return { 
        content: [{ 
          type: "text", 
          text: `Đây là cấu trúc hiện tại của dự án ${targetPath}:\n- ${files.join('\n- ')}` 
        }] 
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Lỗi: ${error.message}` }] };
    }
  }
  throw new Error("Không tìm thấy công cụ");
});

const transport = new StdioServerTransport();
await server.connect(transport);