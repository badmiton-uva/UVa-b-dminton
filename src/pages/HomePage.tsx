import { AboutSection } from '../components/home/AboutSection';
import { AchievementsSection } from '../components/home/AchievementsSection';
import { FollowSection } from '../components/home/FollowSection';
import { Hero } from '../components/home/Hero';
import { LiveNow } from '../components/home/LiveNow';
import { PlayersSection } from '../components/home/PlayersSection';
import { MatchesSection } from '../components/home/MatchesSection';
import { NewsSection } from '../components/home/NewsSection';
import { RankingSection } from '../components/home/RankingSection';
import { QuickContact } from '../components/home/QuickContact';
import { UpcomingSection } from '../components/home/UpcomingSection';
import { usePageTitle } from '../hooks/usePageTitle';

export function HomePage() {
  usePageTitle();
  return (
    <>
      <Hero />
      <LiveNow />
      <NewsSection />
      <RankingSection />
      <AboutSection />
      <PlayersSection />
      <AchievementsSection />
      <FollowSection />
      <UpcomingSection />
      <MatchesSection />
      <QuickContact />
    </>
  );
}
