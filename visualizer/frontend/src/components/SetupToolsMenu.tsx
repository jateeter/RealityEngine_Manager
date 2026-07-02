import React, {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { SettingsModal } from './SettingsModal';
import { LoadMachinesModal } from './LoadMachinesModal';
import './SetupToolsMenu.css';

type MenuItemId = 'settings' | 'load-machines';

interface MenuItem {
  id: MenuItemId;
  label: string;
  icon: string;
}

const MENU_ITEMS: MenuItem[] = [
  { id: 'settings', label: 'Visualizer Settings', icon: '⚙' },
  { id: 'load-machines', label: 'Load Machines…', icon: '⬇' },
];

export function SetupToolsMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadMachinesOpen, setLoadMachinesOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openItem = useCallback((id: MenuItemId) => {
    setMenuOpen(false);
    if (id === 'settings') setSettingsOpen(true);
    if (id === 'load-machines') setLoadMachinesOpen(true);
  }, []);

  // Click-outside dismissal
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Focus first item when menu opens
  useEffect(() => {
    if (menuOpen) {
      requestAnimationFrame(() => { itemRefs.current[0]?.focus(); });
    }
  }, [menuOpen]);

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setMenuOpen(v => !v);
    }
    if (e.key === 'Escape') {
      setMenuOpen(false);
    }
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    const count = MENU_ITEMS.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      itemRefs.current[(idx + 1) % count]?.focus();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      itemRefs.current[(idx - 1 + count) % count]?.focus();
    }
    if (e.key === 'Home') {
      e.preventDefault();
      itemRefs.current[0]?.focus();
    }
    if (e.key === 'End') {
      e.preventDefault();
      itemRefs.current[count - 1]?.focus();
    }
    if (e.key === 'Tab') {
      // Allow natural tab out, close menu
      setMenuOpen(false);
    }
  };

  return (
    <div className="rep-setup-menu">
      <button
        ref={triggerRef}
        className={`rep-setup-menu__trigger rep-help-btn${menuOpen ? ' is-active' : ''}`}
        aria-label="Setup tools"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(v => !v)}
        onKeyDown={handleTriggerKeyDown}
      >
        ⚙
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="rep-setup-menu__dropdown"
          role="menu"
          aria-label="Setup tools menu"
        >
          {MENU_ITEMS.map((item, idx) => (
            <button
              key={item.id}
              ref={el => { itemRefs.current[idx] = el; }}
              className="rep-setup-menu__item"
              role="menuitem"
              onClick={() => openItem(item.id)}
              onKeyDown={e => handleMenuKeyDown(e, idx)}
            >
              <span className="rep-setup-menu__item-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        triggerRef={triggerRef}
      />

      {loadMachinesOpen && (
        <LoadMachinesModal onClose={() => setLoadMachinesOpen(false)} />
      )}
    </div>
  );
}
