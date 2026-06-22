// The 'test_foo_bar' test program.
import foo_bar.aleo;
program test_foo_bar.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = foo_bar.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
