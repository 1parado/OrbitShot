import React from 'react'
import { createRoot } from 'react-dom/client'
import Staging from './Staging'
import './staging.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Staging />
  </React.StrictMode>
)
