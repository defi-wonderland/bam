import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Message in a Blobble';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 240,
          background: '#f0e6d3',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        🏝️
      </div>
    ),
    { ...size }
  );
}
