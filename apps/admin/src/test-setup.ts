import { configure } from '@testing-library/react';

// аудит 2.16: pages are lazy chunks now; the first import of a page in a busy parallel test run takes longer than 1 s
configure({ asyncUtilTimeout: 5000 });
