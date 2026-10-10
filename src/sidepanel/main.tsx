import React from 'react'
import { createRoot } from 'react-dom/client'
import CompareApp from './CompareApp'
import './sidepanel.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CompareApp />
  </React.StrictMode>
)
