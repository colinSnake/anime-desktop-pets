#!/usr/bin/env python3
"""无Qt/素材/账号依赖的松手物理回归；不启动任何应用。"""
import math
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
from pet_release_physics import ReleaseSpring, estimate_release_velocity


class ReleaseVelocityTests(unittest.TestCase):
    def test_uniform_high_rate_events_do_not_inflate_release_speed(self):
        for interval in (.001, .0025, .005, .01, .02):
            with self.subTest(interval=interval):
                trail = [(i * interval, 1000 * i * interval, 0.)
                         for i in range(round(.12 / interval) + 1)]
                vx, vy = estimate_release_velocity(trail, .12)
                self.assertAlmostEqual(vx, 873.1255377709208)
                self.assertEqual(vy, 0.)

    def test_stronger_flicks_remain_distinct_and_bounded(self):
        previous = 0.
        for speed in (400, 1000, 2000, 5000, 10000):
            vx, vy = estimate_release_velocity([(0., 0., 0.), (.1, speed*.1, 0.)], .1)
            self.assertGreater(vx, previous)
            self.assertLess(vx, 3600.)
            self.assertEqual(vy, 0.)
            previous = vx

    def test_soft_limit_preserves_all_diagonal_directions(self):
        for x, y in ((300, 400), (-300, 400), (300, -400), (-300, -400)):
            with self.subTest(direction=(x, y)):
                vx, vy = estimate_release_velocity([(0., 0., 0.), (.1, x, y)], .1)
                self.assertAlmostEqual(vx/vy, x/y)
                self.assertEqual(vx > 0, x > 0)
                self.assertEqual(vy > 0, y > 0)

    def test_hold_at_eighty_ms_boundary_is_a_gentle_drop(self):
        trail = [(.88, 0., 0.), (.92, 40., 0.)]
        self.assertIsNone(estimate_release_velocity(trail, 1.))
        self.assertIsNotNone(estimate_release_velocity(trail, .999))

    def test_noise_and_slow_net_motion_cannot_bypass_flick_gate_with_peaks(self):
        for trail in ([(0., 0., 0.), (.05, 100., 0.), (.1, 0., 0.)],
                      [(0., 0., 0.), (.05, 100., 0.), (.1, 20., 0.)]):
            self.assertIsNone(estimate_release_velocity(trail, .1))

    def test_future_nonfinite_and_short_samples_do_not_produce_velocity(self):
        for trail in ([], [(0., 0., 0.)], [(0., 0., 0.), (.01, 50., 0.)],
                      [(0., 0., 0.), (.1, float('nan'), 0.)],
                      [(0., 0., 0.), (.1, float('inf'), 0.)],
                      [(.2, 0., 0.), (.3, 50., 0.)]):
            with self.subTest(trail=trail):
                self.assertIsNone(estimate_release_velocity(trail, .1))

    def test_old_fast_motion_does_not_leak_into_release_window(self):
        trail = [(0., 0., 0.), (.1, 1000., 0.), (.2, 1000., 0.), (.3, 1010., 0.)]
        self.assertIsNone(estimate_release_velocity(trail, .3))

class ReleasePhysicsTests(unittest.TestCase):
    """Catch component clipping, asymmetric contacts and time-driven fake landings."""

    def test_fast_diagonal_launch_keeps_direction_and_combined_speed_limit(self):
        spring = ReleaseSpring.launch((100, 100), (6000, 8000), (0, 0, 1000, 1000))
        self.assertAlmostEqual(spring.vx / spring.vy, .75)
        self.assertAlmostEqual(math.hypot(spring.vx, spring.vy), 3600.)

    def test_all_four_contacts_reflect_normal_and_only_damp_tangent(self):
        cases = (
            ((1, 100), (-600, 300), (468., 296.875)),
            ((199, 100), (600, 300), (-468., 296.875)),
            ((100, 1), (300, -600), (296.875, 468.)),
            ((100, 199), (300, 600), (296.875, -468.)),
        )
        for origin, velocity, expected in cases:
            with self.subTest(origin=origin):
                spring = ReleaseSpring.launch(origin, velocity, (0, 0, 200, 200))
                spring.gravity = 0.
                spring.restitution = .78
                spring.advance(1 / 240)
                self.assertAlmostEqual(spring.vx, expected[0])
                self.assertAlmostEqual(spring.vy, expected[1])

    def test_eight_second_mark_does_not_replace_gravity_with_scripted_landing(self):
        spring = ReleaseSpring.launch((100, 100), (200, 0), (-10000, -10000, 10000, 10000))
        spring.elapsed = 8.
        spring.advance(1 / 240)
        self.assertGreater(spring.vy, 0.)
        self.assertGreater(spring.y, 100.)
        self.assertEqual(spring.vx, 200.)

    def test_moving_screen_edge_does_not_reverse_inward_velocity(self):
        spring = ReleaseSpring.launch((250, 100), (-500, 200), (0, 0, 300, 400))
        spring.update_bounds((0, 0, 200, 400))
        self.assertEqual(spring.x, 200.)
        self.assertEqual(spring.vx, -500.)

    def test_small_normal_impact_sticks_without_a_micro_bounce(self):
        spring = ReleaseSpring.launch((100, 199.99), (0, 39), (0, 0, 200, 200))
        spring.gravity = 0.
        spring.advance(1 / 240)
        self.assertTrue(spring.settled)
        self.assertEqual(spring.vy, 0.)
        self.assertEqual(spring.y, 200.)


    def test_fixed_substeps_are_independent_of_gui_frame_partition(self):
        springs = [ReleaseSpring.launch((120, 200), (1500, -800), (0, 0, 800, 900))
                   for _ in range(3)]
        for spring, dt in zip(springs, (1/240, 1/60, 1/20)):
            for _ in range(round(4/dt)):
                spring.advance(dt)
        for spring in springs[1:]:
            for field in ('x', 'y', 'vx', 'vy', 'elapsed'):
                self.assertAlmostEqual(getattr(spring, field), getattr(springs[0], field))

    def test_high_energy_throws_naturally_settle_in_negative_and_small_work_areas(self):
        for bounds in ((0, 0, 3000, 2200), (-1400, -240, -600, 700), (20, 30, 21, 31),
                       (10, 10, 10, 10)):
            left, top, right, bottom = bounds
            for velocity in ((3000, -1500), (-3000, 1500), (0, -3600)):
                with self.subTest(bounds=bounds, velocity=velocity):
                    spring = ReleaseSpring.launch(((left+right)/2, (top+bottom)/2), velocity, bounds)
                    for _ in range(240*45):
                        spring.advance(1/240)
                        self.assertTrue(left <= spring.x <= right)
                        self.assertTrue(top <= spring.y <= bottom)
                        if spring.settled:
                            break
                    self.assertTrue(spring.settled)
                    self.assertEqual(spring.y, bottom)
                    self.assertEqual((spring.vx, spring.vy), (0., 0.))


if __name__ == '__main__':
    unittest.main(verbosity=2)
