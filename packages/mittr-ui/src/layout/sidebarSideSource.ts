import { createSidebarSideApi } from './sidebarSideApi';
import { createSidebarSideStore } from './sidebarSideStore';
import './sidebarSide.css';

export const SIDEBAR_SIDE_SOURCE = createSidebarSideStore({ api: createSidebarSideApi() });
