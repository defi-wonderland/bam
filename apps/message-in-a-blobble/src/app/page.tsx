import { IslandScene } from '@/components/IslandScene';
import { MessageComposer } from '@/components/MessageComposer';
import { MessageList } from '@/components/MessageList';
import { PostBlobbleButton } from '@/components/PostBlobbleButton';
import { BlobbleHistory } from '@/components/BlobbleHistory';

export default function Home() {
  return (
    <main className="min-h-screen">
      <IslandScene />
      <div className="max-w-2xl mx-auto px-4 pb-16 -mt-8 relative z-10">
        <MessageComposer />
        <PostBlobbleButton />
        <BlobbleHistory />
        <MessageList />
      </div>
    </main>
  );
}
