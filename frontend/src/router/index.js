import { createRouter, createWebHistory } from 'vue-router'
import App from '../App.vue'
import AdminPanel from '../views/AdminPanel.vue'

const routes = [
    { path: '/', component: App },
    { path: '/admin', component: AdminPanel }
]

const router = createRouter({
    history: createWebHistory(),
    routes
})

export default router
