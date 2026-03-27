import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        slate: {
          850: '#172033',
          950: '#0b1120',
        },
      },
    },
  },
  plugins: [],
};

export default config;
