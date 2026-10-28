import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('../lib/content/', import.meta.url), { recursive: true });
await copyFile(new URL('../content/course.json', import.meta.url), new URL('../lib/content/course.json', import.meta.url));
console.log('Compiled code and course content are ready in lib/.');
