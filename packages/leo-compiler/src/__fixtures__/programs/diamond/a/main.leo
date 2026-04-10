import b.aleo;
import c.aleo;

program a.aleo {
  @noupgrade
  constructor() {}

  fn top() -> u32 {
    return b.aleo::via_b() + c.aleo::via_c();
  }
}
