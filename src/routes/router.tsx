import { createBrowserRouter } from 'react-router';
import { appRoutes } from './appRoutes';

/** The app's routes (./appRoutes.tsx) in the browser's history. */
export const router = createBrowserRouter(appRoutes);
