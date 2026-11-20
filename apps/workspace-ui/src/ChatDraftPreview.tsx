import Markdown from 'react-markdown';

export default function ChatDraftPreview({ text }: { text: string }) {
  return <section className="chat-draft-preview" aria-label="Markdown 预览" tabIndex={0}>
    <Markdown skipHtml components={{
      a: ({ children }) => <span>{children}</span>,
      img: ({ alt }) => <span>[图片：{alt || '未命名'}，不加载]</span>,
    }}>{text}</Markdown>
  </section>;
}
