import b.aleo;

program a.aleo {
  @noupgrade
  constructor() {}

  fn top() -> u32 {
    return b.aleo::step_b();
  }
}
