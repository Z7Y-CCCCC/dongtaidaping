import { createRouter, createWebHistory } from 'vue-router'
import App from '../App.vue'

const routes = [
    { path: '/', component: App },
    { path: '/admin', component: () => import('../views/AdminPanel.vue') }
]

const router = createRouter({
    history: createWebHistory(),
    routes
})

export default router
