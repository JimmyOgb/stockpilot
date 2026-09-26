import React, { useState, useCallback } from 'react';
import { Navbar } from './components/Navbar.js';
import { MobileMenu } from './components/MobileMenu.js';
import { CinematicHero } from './components/CinematicHero.js';
import { CommandCenter } from './components/CommandCenter.js';
import { StatusModal } from './components/StatusModal.js';
import { useVideoScrub } from './hooks/useVideoScrub.js';

export const VIDEO_URL =
  'https://d8j0ntlcm91z4cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260821_114821_a8ca298f-be2c-4613-a4dd-51b69e16bbde.mp4';

export const App: React.FC = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [statusModalOpen, setStatusModalOpen] = useState<boolean>(false);
  const [activeItem, setActiveItem] = useState<string>('STOCKPILOT');
  const [commandCenterTab, setCommandCenterTab] = useState<string>('PORTFOLIO');

  const {
    containerRef,
    videoRef,
    canvasRef,
    scrollProgress,
    canvasLive
  } = useVideoScrub({ videoSrc: VIDEO_URL });

  const scrollToCommandCenter = useCallback((tab?: string) => {
    if (tab) {
      setCommandCenterTab(tab);
    }
    const el = document.getElementById('command-center');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    } else if (containerRef.current) {
      const totalScrollable = containerRef.current.offsetHeight - window.innerHeight;
      window.scrollTo({
        top: totalScrollable + 20,
        behavior: 'smooth'
      });
    }
  }, [containerRef]);

  const handleSelectItem = useCallback((item: string) => {
    setActiveItem(item);
    setMobileMenuOpen(false);

    if (item === 'STOCKPILOT') {
      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
      return;
    }

    if (item === 'STRATEGY') {
      scrollToCommandCenter('STRATEGY');
      return;
    }

    if (item === 'MARKETS' || item === 'MARKET') {
      scrollToCommandCenter('MARKET');
      return;
    }

    if (item === 'VERIFICATION') {
      scrollToCommandCenter('VERIFICATION');
      return;
    }

    if (item === 'EXECUTION' || item === 'AGENT') {
      scrollToCommandCenter('EXECUTION');
      return;
    }

    if (item === 'STATUS') {
      setStatusModalOpen(true);
      return;
    }
  }, [scrollToCommandCenter]);

  const handleLaunch = useCallback(() => {
    scrollToCommandCenter('PORTFOLIO');
  }, [scrollToCommandCenter]);

  return (
    <div className="relative min-h-screen bg-[#080D16] text-slate-100 selection:bg-cyan-500/20 selection:text-cyan-200">
      {/* Sticky Navbar at z-50 */}
      <Navbar
        scrollProgress={scrollProgress}
        onOpenMobileMenu={() => setMobileMenuOpen(true)}
        activeItem={activeItem}
        onSelectItem={handleSelectItem}
        onOpenStatus={() => setStatusModalOpen(true)}
      />

      {/* Fullscreen Mobile Menu Drawer */}
      <MobileMenu
        isOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        activeItem={activeItem}
        onSelectItem={handleSelectItem}
        onOpenStatus={() => {
          setMobileMenuOpen(false);
          setStatusModalOpen(true);
        }}
      />

      {/* System Status Modal */}
      <StatusModal
        isOpen={statusModalOpen}
        onClose={() => setStatusModalOpen(false)}
      />

      {/* Main Experience */}
      <main>
        {/* Layers 1, 2, 3: Cinematic Hero Viewport (500vh Track) */}
        <CinematicHero
          containerRef={containerRef}
          videoRef={videoRef}
          canvasRef={canvasRef}
          scrollProgress={scrollProgress}
          canvasLive={canvasLive}
          videoSrc={VIDEO_URL}
          onLaunch={handleLaunch}
        />

        {/* Section 5 & 6: Institutional Command Center Dashboard */}
        <CommandCenter
          activeTab={commandCenterTab}
          onSelectTab={(tab) => {
            setCommandCenterTab(tab);
            setActiveItem(tab);
          }}
          onOpenStatusModal={() => setStatusModalOpen(true)}
        />
      </main>
    </div>
  );
};

export default App;
